import { NextResponse } from "next/server";

type RainViewerFrame = {
  time: number;
  path: string;
};

type RainViewerPayload = {
  generated: number;
  host: string;
  radar?: {
    past?: RainViewerFrame[];
    nowcast?: RainViewerFrame[];
  };
};

export const revalidate = 300;

export async function GET() {
  try {
    const response = await fetch("https://api.rainviewer.com/public/weather-maps.json", {
      headers: { accept: "application/json" },
      next: { revalidate: 300 },
    });

    if (!response.ok) {
      throw new Error(`RainViewer responded with ${response.status}`);
    }

    const payload = (await response.json()) as RainViewerPayload;
    const frames = [...(payload.radar?.nowcast ?? []), ...(payload.radar?.past ?? [])];
    const latest = frames.sort((a, b) => b.time - a.time)[0];

    if (!latest) {
      return NextResponse.json(
        { error: "No RainViewer radar frame is currently available" },
        { status: 404 },
      );
    }

    return NextResponse.json(
      {
        generatedAt: new Date(payload.generated * 1000).toISOString(),
        frameTime: new Date(latest.time * 1000).toISOString(),
        tileUrl: `${payload.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`,
        source: "RainViewer Weather Maps API",
      },
      {
        headers: {
          "Cache-Control": "s-maxage=300, stale-while-revalidate=900",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "Unable to load RainViewer radar metadata",
        detail: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 502 },
    );
  }
}
