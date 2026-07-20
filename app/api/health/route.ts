export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      status: "ok",
      service: "sponsor-winback-radar"
    },
    {
      headers: {
        "cache-control": "no-store"
      }
    }
  );
}
