import { Icon } from "../icons";
import { Card } from "./primitives";

export const AD_SEPARATION =
  "Your Voom subscription pays for the software. Advertising budgets are optional and paid directly through your connected advertising account.";

export function AdSepNote() {
  return (
    <Card className="bg-surface-2 p-4">
      <div className="flex items-start gap-2.5">
        <span className="grid flex-none place-items-center text-brand">
          <Icon name="wallet" />
        </span>
        <p className="text-[12.8px] leading-[1.6] text-text-2">{AD_SEPARATION}</p>
      </div>
    </Card>
  );
}
