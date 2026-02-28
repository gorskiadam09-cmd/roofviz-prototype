import { put } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { imageData } = await req.json() as { imageData: string };

  if (!imageData) {
    return NextResponse.json({ error: "Missing imageData" }, { status: 400 });
  }

  const base64 = imageData.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(base64, "base64");
  const filename = `roofviz-${Date.now()}.jpg`;

  const blob = await put(filename, buffer, {
    access: "public",
    contentType: "image/jpeg",
  });

  return NextResponse.json({ url: blob.url });
}
