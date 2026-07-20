import { SponsorRadarDemo } from "@/components/sponsor-radar-demo";

export default function HomePage() {
  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">YouTube sponsor opportunities</p>
        <h1>Sponsor Winback Radar</h1>
        <p className="lede">
          Enter a YouTube channel and get a concise, evidence-backed list of
          past sponsors worth contacting again. The agent handles peer
          discovery, sponsor research, and verification in the background.
        </p>
      </header>
      <SponsorRadarDemo />
    </main>
  );
}
