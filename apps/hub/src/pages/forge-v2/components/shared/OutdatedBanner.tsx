interface Props {
  message?: string;
}

export function OutdatedBanner({ message }: Props) {
  return (
    <div className="ps-outdated-banner">
      <span className="ps-outdated-icon">!</span>
      <span>{message ?? "Upstream changes detected. Regenerate to update."}</span>
    </div>
  );
}
