export default function Waveform({ isPlaying = false }: { isPlaying?: boolean }) {
  const bars = 32;

  return (
    <div className="flex items-end justify-center gap-[1px] h-10">
      {Array.from({ length: bars }).map((_, i) => {
        const delay = i * 0.04;

        return (
          <div
            key={i}
            className="w-[2px] rounded-full transition-all duration-300"
            style={{
              height: isPlaying ? undefined : "15%",
              background: isPlaying
                ? "var(--ps-pearl-gradient)"
                : "var(--ps-graphite-600)",
              animation: isPlaying
                ? `ps-waveform 0.7s ease-in-out ${delay}s infinite`
                : "none",
            }}
          />
        );
      })}
    </div>
  );
}
