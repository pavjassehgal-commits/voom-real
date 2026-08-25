"use client";

import { useVoomActions } from "@/lib/voom/store";
import type { ChatMessage } from "@/lib/voom/types";
import { Orb } from "../ui/primitives";

export function ChatBubble({ message }: { message: ChatMessage }) {
  const { goTo, askMara, approveAllDrafts } = useVoomActions();

  function runAction(target: string) {
    if (target === "__approveAllDrafts") {
      approveAllDrafts();
      return;
    }
    if (target.startsWith("__ask:")) {
      askMara(target.slice(6), () => goTo("mara"));
      return;
    }
    goTo(target);
  }

  if (message.r === "me") {
    return (
      <div className="flex max-w-[88%] animate-[pop_.3s_cubic-bezier(.2,.9,.3,1.3)] justify-end self-end sm:max-w-[78%]">
        <div
          className="voom-grad rounded-[16px] rounded-br-[5px] px-4 py-3 text-[14.2px] leading-[1.58] text-white"
          dangerouslySetInnerHTML={{ __html: message.h }}
        />
      </div>
    );
  }

  return (
    <div className="flex max-w-[88%] animate-[pop_.3s_cubic-bezier(.2,.9,.3,1.3)] gap-2.5 sm:max-w-[78%]">
      <Orb size="sm" className="mt-1" />
      <div className="rounded-[16px] rounded-bl-[5px] border border-line bg-surface-2 px-4 py-3 text-[14.2px] leading-[1.58]">
        <div dangerouslySetInnerHTML={{ __html: message.h }} />
        {message.acts && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {message.acts.map(([label, target]) => (
              <button
                key={label}
                onClick={() => runAction(target)}
                className="inline-flex h-[34px] items-center justify-center rounded-[9px] border border-line-2 px-3.5 text-[13px] font-semibold transition hover:bg-surface-3"
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
