import { type ReactNode, useEffect, useRef } from "react";
import { Icon } from "../../shared/Icons";
import "./agent-canvas.css";

export function AgentCanvas({ mode, suggestions, composer, conversation, turnCount, busy = false, topAction }: {
  mode: string; suggestions?: ReactNode; composer: ReactNode; conversation?: ReactNode;
  turnCount: number; busy?: boolean; topAction?: ReactNode;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (turnCount || busy) end.current?.scrollIntoView?.({block:"nearest"});
  }, [turnCount, busy]);
  return <section className="adc-agent" aria-label="经营智能助手">
    <header className="adc-agent-header">
      <span className="adc-agent-icon"><Icon name="activity" size={24}/></span>
      <div><h2>经营智能助手</h2><p>门店履约、诊疗实收与经营制度</p></div>
      <span className="adc-agent-mode">{mode}</span>{topAction}
    </header>
    <div className="adc-agent-log" role="log" aria-label="经营对话" aria-live="polite">
      {!turnCount && !busy && <div className="adc-agent-welcome">
        <span className="adc-agent-emblem"><Icon name="activity" size={35}/></span>
        <h3>今天想了解哪些经营数据？</h3>
        <p>问我两店的就诊率、到期未处置或诊疗净实收。回答可回查原报表。</p>
      </div>}
      {conversation}
      {busy && <p role="status" className="adc-agent-loading">正在查阅报表并生成解读…</p>}
      <div ref={end}/>
    </div>
    <footer className="adc-agent-footer">{suggestions}{composer}</footer>
  </section>;
}

export function AgentTurn({prompt, children}: {prompt: string; children: ReactNode}) {
  return <article className="adc-agent-turn">
    <p className="adc-agent-prompt">{prompt}</p>
    <div className="adc-agent-answer"><span className="adc-agent-icon"><Icon name="activity" size={16}/></span>
      <div className="adc-agent-answer-body">{children}</div></div>
  </article>;
}

export function AgentComposer({question, change, submit, locked = false, busy = false}: {
  question: string; change: (value:string)=>void; submit: ()=>void; locked?: boolean; busy?: boolean;
}) {
  function send() { if (question.trim() && !locked) submit(); }
  return <form className="adc-agent-composer" onSubmit={event=>{event.preventDefault();send();}}>
    <textarea aria-label="经营问题" value={question} maxLength={160} rows={2} disabled={locked}
      placeholder="输入经营问题，Enter 发送"
      onChange={event=>change(event.target.value)}
      onKeyDown={event=>{
        if (event.key!=="Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();send();
      }}/>
    <button type="submit" disabled={locked || !question.trim()} aria-label="发送">
      {busy?"正在分析":"发送"} <Icon name="arrow" size={17}/></button>
  </form>;
}
