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
    const past = payload.radar?.past ?? [];
    const nowcast = payload.radar?.nowcast ?? [];

    // Animation set: last ~90 minutes of observations + the forecast frames.
    // Each frame is 10 minutes apart, so 9 past + up to 3 nowcast ≈ 2 hours.
    const frames = [...past.slice(-9), ...nowcast].map((f) => ({
      time: f.time,
      path: f.path,
      // Frames newer than "generated" are nowcast (forecast, not observed).
      nowcast: f.time > payload.generated,
    }));

    if (frames.length === 0) {
      return NextResponse.json(
        { error: "No RainViewer radar frame is currently available" },
        { status: 404 },
      );
    }

    let latestIndex = 0;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (!frames[i].nowcast) {
        latestIndex = i;
        break;
      }
    }
    const latest = frames[latestIndex];

    return NextResponse.json(
      {
        generatedAt: new Date(payload.generated * 1000).toISOString(),
        host: payload.host,
        frames,
        latestIndex,
        // Kept for anything still reading the single-frame shape.
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
