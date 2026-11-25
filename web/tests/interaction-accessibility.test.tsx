import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { ScheduleDrawer } from "../src/features/schedule/AppointmentDrawer";

afterEach(cleanup);

test("opening an appointment drawer focuses its close button and Escape restores the trigger", () => {
  function Example() {
    const [visible, setVisible] = useState(false);
    return <>
      <button onClick={() => setVisible(true)}>合成预约</button>
      {visible && <ScheduleDrawer title="预约详情" onClose={() => setVisible(false)}><p>预约号 ADC-UX</p></ScheduleDrawer>}
    </>;
  }
  render(<Example />);
  const trigger = screen.getByRole("button", { name: "合成预约" });
  trigger.focus();
  fireEvent.click(trigger);
  const close = screen.getByRole("button", { name: "关闭详情" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Escape" });
  expect(screen.queryByRole("complementary")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
