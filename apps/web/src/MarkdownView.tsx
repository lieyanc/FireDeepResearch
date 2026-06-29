import type { ArtifactRef } from "@fdr/schemas";
import type { ReactNode } from "react";
import { artifactIdPattern } from "./artifactRefs";

export function MarkdownView({
  body,
  artifactById,
  onArtifactRefClick,
}: {
  body: string;
  artifactById: Map<string, ArtifactRef>;
  onArtifactRefClick: (artifact: ArtifactRef) => void;
}) {
  const blocks = body.split("\n");
  const renderInline = (value: string, keyPrefix: string): ReactNode[] => {
    const nodes: ReactNode[] = [];
    let lastIndex = 0;
    for (const match of value.matchAll(artifactIdPattern)) {
      const id = match[0];
      const index = match.index ?? 0;
      if (index > lastIndex) {
        nodes.push(value.slice(lastIndex, index));
      }
      const artifact = artifactById.get(id);
      nodes.push(
        artifact ? (
          <button
            className="artifact-ref-chip"
            key={`${keyPrefix}-${index}-${id}`}
            onClick={() => onArtifactRefClick(artifact)}
            data-artifact-id={id}
          >
            {id}
          </button>
        ) : (
          id
        ),
      );
      lastIndex = index + id.length;
    }
    if (lastIndex < value.length) {
      nodes.push(value.slice(lastIndex));
    }
    return nodes;
  };

  const nodes = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const line = blocks[index];
    const nextLine = blocks[index + 1] ?? "";
    const isTableStart = line.trim().startsWith("|") && nextLine.trim().startsWith("|") && /---/.test(nextLine);
    if (isTableStart) {
      const rows: string[][] = [];
      let cursor = index;
      while (cursor < blocks.length && blocks[cursor].trim().startsWith("|")) {
        if (!/^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(blocks[cursor].trim())) {
          rows.push(
            blocks[cursor]
              .trim()
              .replace(/^\||\|$/g, "")
              .split("|")
              .map((cell) => cell.trim()),
          );
        }
        cursor += 1;
      }
      const [headers, ...bodyRows] = rows;
      nodes.push(
        <div className="md-table-wrap" key={index}>
          <table>
            <thead>
              <tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell, `${index}-h-${cellIndex}`)}</th>)}</tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => <td key={cellIndex}>{renderInline(cell, `${index}-${rowIndex}-${cellIndex}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      index = cursor - 1;
      continue;
    }

    if (line.startsWith("# ")) {
      nodes.push(<h1 key={index}>{renderInline(line.slice(2), `${index}-h1`)}</h1>);
      continue;
    }
    if (line.startsWith("## ")) {
      nodes.push(<h2 key={index}>{renderInline(line.slice(3), `${index}-h2`)}</h2>);
      continue;
    }
    if (line.startsWith("### ")) {
      nodes.push(<h3 key={index}>{renderInline(line.slice(4), `${index}-h3`)}</h3>);
      continue;
    }
    if (line.startsWith("> ")) {
      nodes.push(<blockquote key={index}>{renderInline(line.slice(2), `${index}-quote`)}</blockquote>);
      continue;
    }
    if (line.startsWith("- ")) {
      nodes.push(<li key={index}>{renderInline(line.slice(2), `${index}-li`)}</li>);
      continue;
    }
    if (!line.trim()) {
      nodes.push(<div key={index} className="md-gap" />);
      continue;
    }
    nodes.push(<p key={index}>{renderInline(line, `${index}-p`)}</p>);
  }
  return <div className="markdown-view">{nodes}</div>;
}
