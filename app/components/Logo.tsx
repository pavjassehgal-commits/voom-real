import { VoomLogoMark } from "@/components/voom/shell/VoomLogo";

export default function Logo() {
  return (
    <div className="flex items-center gap-2.5 font-display font-bold text-xl tracking-tight">
      <VoomLogoMark size={32} />
      Voom
    </div>
  );
}
