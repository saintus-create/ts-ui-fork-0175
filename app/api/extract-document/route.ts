import pdfParse from "pdf-parse";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".pdf")) return Response.json({ error: "Attach a PDF document." }, { status: 400 });
  if (file.size > 4000000) return Response.json({ error: "PDF limit is 4 MB." }, { status: 413 });
  try {
    const parsed = await pdfParse(Buffer.from(await file.arrayBuffer()));
    const text = String(parsed.text || "").trim();
    if (!text) return Response.json({ error: "No selectable text found. Scanned PDFs require OCR." }, { status: 422 });
    return Response.json({ name: file.name, text: text.slice(0, 100000), pages: parsed.numpages });
  } catch {
    return Response.json({ error: "Could not extract text from this PDF." }, { status: 422 });
  }
}
