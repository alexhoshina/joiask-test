import { Buffer } from 'node:buffer';
import { crc32, deflateSync } from 'node:zlib';
import { readLimited } from './uploads';

const palette = {
  red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
  cyan: [0, 255, 255], magenta: [255, 0, 255], black: [0, 0, 0], white: [255, 255, 255],
};

function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function colorChart() {
  const available = Object.keys(palette) as (keyof typeof palette)[];
  const colors = Array.from(crypto.getRandomValues(new Uint32Array(4)), random =>
    available.splice(random % available.length, 1)[0]);
  const width = 192, height = 64, band = width / colors.length;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // Eight bits per palette index.
  header[9] = 3; // Indexed-color PNG.
  const row = Buffer.alloc(1 + width); // Filter byte zero, then one index per pixel.
  colors.forEach((_, i) => row.fill(i, 1 + i * band, 1 + (i + 1) * band));
  const pixels = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(pixels, y * row.length);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('PLTE', Buffer.from(colors.flatMap(color => palette[color]))),
    pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return { colors, url: 'data:image/png;base64,' + png.toString('base64') };
}

export async function verifyVision(endpoint: string, model: string, apiKey: string, timeoutSeconds: number):
  Promise<'passed' | 'failed' | 'timeout'> {
  const chart = colorChart();
  const signal = AbortSignal.timeout(timeoutSeconds * 1000);
  try {
    const response = await fetch(endpoint + '/chat/completions', {
      method: 'POST', redirect: 'manual', signal,
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 512, response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Read the four vertical color bands from left to right. Respond with a JSON object ' +
            'with a "colors" array of four lowercase English names. Allowed names: ' + Object.keys(palette).join(', ') + '.' },
          { type: 'image_url', image_url: { url: chart.url } },
        ] }],
      }),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return 'failed';
    }
    const bytes = await readLimited(response.body, 65536);
    const completion = JSON.parse(new TextDecoder().decode(bytes));
    const { colors } = JSON.parse(completion.choices[0].message.content);
    const matches = Array.isArray(colors) && colors.length === chart.colors.length &&
      chart.colors.every((color, i) => colors[i] === color);
    return matches ? 'passed' : 'failed';
  } catch {
    return signal.aborted ? 'timeout' : 'failed';
  }
}
