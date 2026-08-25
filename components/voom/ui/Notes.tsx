import { Icon } from "../icons";
import { Card, Tag } from "./primitives";

export const PROTO_TEXT = "Prototype demonstration — no real action was performed.";
export const AD_SEPARATION =
  "Your Voom subscription pays for the software. Advertising budgets are optional and paid directly through your connected advertising account.";

export function ProtoNote() {
  return (
    <Card className="border-dashed bg-surface-2 p-4">
      <div className="flex items-start gap-2.5">
        <span className="grid place-items-center text-text-3">
          <Icon name="info" />
        </span>
        <p className="text-[12.8px] leading-[1.55] text-text-2">
          <b>{PROTO_TEXT}</b>
        </p>
      </div>
    </Card>
  );
}

export function AdSepNote() {
  return (
    <Card className="bg-surface-2 p-4">
      <div className="flex items-start gap-2.5">
        <span className="grid place-items-center text-brand">
          <Icon name="wallet" />
        </span>
        <p className="text-[12.8px] leading-[1.6] text-text-2">{AD_SEPARATION}</p>
      </div>
    </Card>
  );
}

export function DemoTag() {
  return <Tag tone="t-grey">Demo data</Tag>;
}

export function ExTag() {
  return <Tag tone="t-grey">Example result</Tag>;
}
