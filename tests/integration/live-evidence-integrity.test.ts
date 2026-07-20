import { describe, expect, it } from "vitest";
import { LiveUpriverGateway } from "@/src/radar/adapters/upriver/live-evidence-gateway";
import {
  UpriverHttpClient,
  type UpriverFetch
} from "@/src/radar/adapters/upriver/http-client";

describe("live Upriver publication integrity", () => {
  it("rejects a sponsor row attributed to a different publication", async () => {
    const fetch: UpriverFetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              partner_name: "Dell",
              sponsor_domain: "dell.com",
              total_ads_found: 1,
              most_recent_ad: {
                publication_name: "Different Creator",
                publication_url:
                  "https://www.youtube.com/@DifferentCreator",
                publication_categories: ["Technology"],
                publication_platform: "youtube",
                content_url:
                  "https://www.youtube.com/watch?v=wrong-publication",
                sponsor_type: "explicit_ad",
                published_date: "2026-06-16",
                evidence: {
                  source: "description",
                  excerpt: "Sponsored by Dell.",
                  confidence: 1
                }
              }
            }
          ],
          total_count: 1,
          has_more: false,
          next_cursor: null
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    const gateway = new LiveUpriverGateway(
      process.cwd(),
      new UpriverHttpClient({
        apiKey: "server-only-test-key",
        fetch,
        maxRetries: 0
      }),
      { maximumCredits: 5, targetResultCap: 1, peerResultCap: 1 }
    );

    await expect(
      gateway.listTargetSponsors(
        "https://www.youtube.com/@UrAvgConsumer"
      )
    ).rejects.toThrow(/requested publication/);
    expect(gateway.creditSnapshot()).toMatchObject({
      resultBasedCredits: 5,
      reservedCredits: 0
    });
  });

  it("rejects another publication's active tracking status even with zero rows", async () => {
    const fetch: UpriverFetch = async () =>
      new Response(
        JSON.stringify({
          results: [],
          total_count: 0,
          has_more: false,
          next_cursor: null,
          tracking_status: {
            publication_url:
              "https://www.youtube.com/@DifferentCreator",
            channel_name: "Different Creator",
            status: "active",
            message: "Tracking is active"
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    const gateway = new LiveUpriverGateway(
      process.cwd(),
      new UpriverHttpClient({
        apiKey: "server-only-test-key",
        fetch,
        maxRetries: 0
      }),
      { maximumCredits: 5, targetResultCap: 1, peerResultCap: 1 }
    );

    await expect(
      gateway.listTargetSponsors(
        "https://www.youtube.com/@UrAvgConsumer"
      )
    ).rejects.toThrow(/requested publication/);
    expect(gateway.creditSnapshot()).toMatchObject({
      resultBasedCredits: 0,
      reservedCredits: 0
    });
  });
});
