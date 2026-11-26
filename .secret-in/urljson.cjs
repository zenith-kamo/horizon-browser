const input = [];
process.stdin.on('data', (c) => input.push(c));
process.stdin.on('end', () => {
  const text = Buffer.concat(input).toString('utf8').trim();
  const lines = text ? text.split(/\r?\n/) : [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      process.stdout.write(String(entry.url || entry.link || entry.value || line) + '\n');
    } catch (e) {
      process.stdout.write(line + '\n');
    }
  }
});
