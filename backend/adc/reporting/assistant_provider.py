from dataclasses import dataclass
import json
import re
from time import monotonic
from urllib.request import HTTPRedirectHandler, Request, build_opener

from django.conf import settings


ENDPOINT = "https://api.deepseek.com/chat/completions"
MAX_CALLS = 3
MAX_RESPONSE_BYTES = 64 * 1024
MAX_REQUEST_BYTES = 24 * 1024
REQUEST_TIMEOUT = 5
TOTAL_TIMEOUT = 12
SYSTEM_MESSAGE = (
    "你是合成环境的 ADC 经营助手。先调用工具。工具返回 observations（每项含 id、text、source_id）、"
    "questions（每项含 id、text）和 sources（每项含 id）。最终只输出 JSON 对象，且仅包含 "
    "observations、questions、sources 三个数组。observations 数组只能填 observations[].id，"
    "questions 数组只能填 questions[].id，sources 数组只能填 sources[].id。"
    "至少选择一条观察并引用它对应的 source_id；可以排序或忽略次要内容。"
    "不要输出原文、客户资料、数字、因果结论或其它字段。"
)


class InvalidModel(ValueError):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


@dataclass(frozen=True)
class Tool:
    description: str
    arguments: dict
    data: dict

    def schema(self, name):
        return {
            "type": "function", "function": {
                "name": name, "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {key: {"type": "string", "enum": [value]} for key, value in self.arguments.items()},
                    "required": list(self.arguments), "additionalProperties": False,
                },
            },
        }


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def read_completion(messages, tools, choice, deadline):
    remaining = deadline - monotonic()
    if remaining <= 0:
        raise TimeoutError
    payload = {
        "model": settings.ADC_DEEPSEEK_MODEL, "messages": messages,
        "thinking": {"type": "disabled"}, "tools": tools, "tool_choice": choice,
        "response_format": {"type": "json_object"}, "max_tokens": 512,
    }
    body = json_text(payload).encode()
    if len(body) > MAX_REQUEST_BYTES:
        raise InvalidModel
    request = Request(
        ENDPOINT, data=body, method="POST",
        headers={"Authorization": f"Bearer {settings.ADC_DEEPSEEK_API_KEY}", "Content-Type": "application/json"},
    )
    with build_opener(NoRedirect()).open(request, timeout=min(REQUEST_TIMEOUT, remaining)) as response:
        raw = bytearray()
        while monotonic() < deadline:
            part = response.read1(8192)
            if not part:
                return json.loads(raw)
            raw.extend(part)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise InvalidModel
    raise TimeoutError


def arrange(intent, tools, required_tool, guard_scope, used_tools, usage):
    messages = [{"role": "system", "content": SYSTEM_MESSAGE}, {"role": "user", "content": json_text(intent)}]
    definitions = [tool.schema(name) for name, tool in tools.items()]
    deadline = monotonic() + TOTAL_TIMEOUT
    call_ids = set()

    for round_index in range(MAX_CALLS):
        # The first round fetches the authorized summary/report evidence. Later rounds are
        # answer-only; DeepSeek otherwise tends to emit parallel tool calls that cannot be
        # mapped back to a single approved observation set.
        choice = {"type": "function", "function": {"name": required_tool}} if round_index == 0 else "none"
        # DeepSeek may return several parallel calls when more tools are visible. The first
        # round only needs the required summary/report tool, so expose exactly that one.
        round_definitions = [tools[required_tool].schema(required_tool)] if round_index == 0 else definitions
        usage["calls"] += 1
        result = read_completion(messages, round_definitions, choice, deadline)
        for key in ("prompt_tokens", "completion_tokens"):
            count = (result.get("usage") or {}).get(key, 0)
            if type(count) is int and 0 <= count <= 1_000_000:
                usage[key] += count
        [answer] = result["choices"]
        message = answer["message"]
        if message["role"] != "assistant":
            raise InvalidModel
        calls = message.get("tool_calls")
        if not calls:
            if answer["finish_reason"] != "stop" or required_tool not in used_tools:
                raise InvalidModel
            return json.loads(message["content"])
        if answer["finish_reason"] != "tool_calls" or round_index == MAX_CALLS - 1 or len(calls) != 1:
            raise InvalidModel

        [call] = calls
        name = call["function"]["name"]
        call_id = call["id"]
        tool = tools.get(name)
        arguments = json.loads(call["function"]["arguments"])
        if (
            call["type"] != "function" or tool is None or arguments != tool.arguments or name in used_tools
            or (round_index == 0 and name != required_tool)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", call_id) or call_id in call_ids
        ):
            raise InvalidModel
        guard_scope()
        call_ids.add(call_id)
        used_tools.append(name)
        checked_call = {
            "id": call_id, "type": "function", "function": {"name": name, "arguments": json_text(tool.arguments)},
        }
        messages.extend((
            {"role": "assistant", "content": None, "tool_calls": [checked_call]},
            {"role": "tool", "tool_call_id": call_id, "content": json_text(tool.data)},
        ))
    raise InvalidModel
