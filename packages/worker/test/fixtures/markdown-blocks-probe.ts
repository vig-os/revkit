import { parseMarkdownBlocks } from "@revkit/review-core/markdown-blocks";
import { prepareSegmentation, safePreparedEndpoints } from "@revkit/review-core/block-preparation";
export default {
  async fetch(request: Request): Promise<Response> {
    const source = await request.text();
    const map = await parseMarkdownBlocks(source);
    const segmentation = prepareSegmentation(source.replace(/\r\n?/g, "\n"));
    return Response.json({ map, boundaries: { grapheme: [...segmentation.graphemeBoundary], interior: [...segmentation.wordInterior], end: [...segmentation.wordEnd] }, safe: safePreparedEndpoints(segmentation, 0, 1) });
  },
};
