export const TOOL_REGISTRY = {
  resolveCreator: {
    executable: true,
    adapterPort: "SponsorRadarEvidencePort.resolveTarget",
    requiresUserApproval: true,
    maySpendCreditsInLiveMode: true,
    skillSection: "Creators"
  },
  listTargetSponsors: {
    executable: true,
    adapterPort: "SponsorRadarEvidencePort.listTargetSponsors",
    requiresUserApproval: true,
    maySpendCreditsInLiveMode: true,
    skillSection: "Sponsorships"
  },
  listPeerSponsors: {
    executable: true,
    adapterPort: "SponsorRadarEvidencePort.listPeerSponsors",
    requiresUserApproval: true,
    maySpendCreditsInLiveMode: true,
    skillSection: "Sponsorships"
  },
  brandResearch: {
    executable: false,
    adapterPort: "Deferred beyond the Phase 2A sponsorship-evidence gate",
    requiresUserApproval: true,
    maySpendCreditsInLiveMode: true,
    skillSection: "Brands"
  }
} as const;

export type SponsorRadarToolName = keyof typeof TOOL_REGISTRY;
