export default function Logo() {
  return (
    <div className="flex items-center gap-2.5 font-display font-bold text-xl tracking-tight">
      <span className="voom-grad flex h-8 w-8 flex-none items-center justify-center rounded-[10px] shadow-[0_6px_16px_-6px_var(--brand)]">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-[19px] w-[19px]"
        >
          <path d="M13 2L3 14h8l-1 8 10-12h-8z" />
        </svg>
      </span>
      Voom
    </div>
  );
}
