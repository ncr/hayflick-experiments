import { useEffect } from "react";
import { useAppState, useAppDispatch } from "../state/context";

const TOAST_TIMEOUT = 5000;

export function Toasts() {
  const { toasts } = useAppState();
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!toasts.length) return;
    const latest = toasts[toasts.length - 1];
    const timer = setTimeout(() => dispatch({ type: "TOAST_DISMISS", id: latest.id }), TOAST_TIMEOUT);
    return () => clearTimeout(timer);
  }, [toasts, dispatch]);

  if (!toasts.length) return null;
  return (
    <div className="ms-toast-stack">
      {toasts.map((t) => (
        <button
          key={t.id}
          className={`ms-toast ms-toast-${t.level}`}
          onClick={() => dispatch({ type: "TOAST_DISMISS", id: t.id })}
          title="Dismiss"
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
