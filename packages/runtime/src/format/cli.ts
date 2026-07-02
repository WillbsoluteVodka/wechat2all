function cleanLine(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  return line.replace(/\s+$/g, "");
}

function headerLine(title: string): string {
  return `+${"-".repeat(title.length + 2)}+`;
}

export function cliPanel(title: string, lines: Array<string | undefined>): string {
  const body = lines
    .map(cleanLine)
    .filter((line): line is string => line !== undefined);
  const line = headerLine(title);
  return [
    line,
    `| ${title} |`,
    line,
    ...body,
  ].join("\n");
}

export function cliUsage(command: string, description?: string): string {
  return cliPanel("usage", [
    command,
    description ? `  ${description}` : undefined,
  ]);
}

export function cliError(title: string, lines: Array<string | undefined>): string {
  return cliPanel(`error: ${title}`, lines);
}

export function cliOk(title: string, lines: Array<string | undefined>): string {
  return cliPanel(`ok: ${title}`, lines);
}
