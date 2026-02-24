import { put } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { imageData } = (await req.json()) as { imageData: string };
    if (!imageData) {
      return NextResponse.json({ error: "Missing imageData" }, { status: 400 });
    }
    const base64 = imageData.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64, "base64");
    const blob = await put(
      `preview-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
      buffer,
      { access: "public", contentType: "image/jpeg" }
    );
    return NextResponse.json({ url: blob.url });
  } catch (err) {
    console.error("store-photo error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
