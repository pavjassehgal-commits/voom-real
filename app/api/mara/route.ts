export const runtime = "nodejs";

export async function GET() {
  return Response.json({ error: "Deprecated." }, { status: 410 });
}

export async function POST() {
  return Response.json({ error: "Deprecated. Use the Marketing Plan workflow." }, { status: 410 });
}
