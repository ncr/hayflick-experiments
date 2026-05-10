import { useEffect, useRef, useSyncExternalStore } from "react";
import type { DebugSinkHandle } from "../runtime/createDebugSink";

type Props = {
  handle: DebugSinkHandle;
};

export function ConsolePane({ handle }: Props) {
  const messages = useSyncExternalStore(
    (cb) => handle.subscribe(cb),
    () => handle.getMessages(),
    () => handle.getMessages()
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="game-studio-console-list" ref={scrollRef}>
      {messages.length === 0 && (
        <div className="game-studio-console-empty">No log output yet.</div>
      )}
      {messages.map((m, i) => (
        <div key={i} className="game-studio-console-line">
          <span className="game-studio-console-frame">[{m.frame}]</span>
          <span className="game-studio-console-msg">{m.message}</span>
        </div>
      ))}
    </div>
  );
}
