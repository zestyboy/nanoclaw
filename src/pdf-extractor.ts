import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  GROUPS_DIR,
  NANOCLAW_PDF_EXTRACT_MAX_CHARS,
  PUBLIC_KNOWLEDGE_DIR,
  PROJECTS_DIR,
  SECOND_BRAIN_DIR,
} from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';

export interface PdfExtractionRequest {
  sourceGroup: string;
  sourcePath: string;
  isElevated: boolean;
  pageStart?: number;
  pageEnd?: number;
}

export interface PdfExtractionResult {
  sourcePath: string;
  extractedTextPath: string;
  pageCount: number | null;
  characterCount: number;
  excerpt: string;
  scanCandidate: boolean;
  ocrAvailable: false;
}

interface ResolvedPdfPath {
  hostPath: string;
  visiblePath: string;
  groupDir: string;
  useWorkspacePaths: boolean;
}

function ensureWithinRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveWorkspacePdfPath(
  sourceGroup: string,
  sourcePath: string,
  isElevated: boolean,
): ResolvedPdfPath {
  const roots: Array<{
    containerPrefix: string;
    hostRoot: string;
  }> = [
    {
      containerPrefix: '/workspace/group',
      hostRoot: resolveGroupFolderPath(sourceGroup),
    },
  ];

  if (PUBLIC_KNOWLEDGE_DIR) {
    roots.push({
      containerPrefix: '/workspace/public-knowledge',
      hostRoot: PUBLIC_KNOWLEDGE_DIR,
    });
  }
  if (SECOND_BRAIN_DIR) {
    roots.push({
      containerPrefix: '/workspace/second-brain',
      hostRoot: SECOND_BRAIN_DIR,
    });
  }
  if (isElevated) {
    roots.push({
      containerPrefix: '/workspace/all-groups',
      hostRoot: GROUPS_DIR,
    });
    roots.push({
      containerPrefix: '/workspace/projects',
      hostRoot: PROJECTS_DIR,
    });
  }

  const normalizedInput = path.posix.normalize(sourcePath.trim());
  for (const root of roots) {
    if (
      normalizedInput === root.containerPrefix ||
      normalizedInput.startsWith(`${root.containerPrefix}/`)
    ) {
      const relative = normalizedInput.slice(root.containerPrefix.length);
      const hostPath = path.resolve(root.hostRoot, `.${relative}`);
      if (!ensureWithinRoot(root.hostRoot, hostPath)) {
        throw new Error(`Path escapes workspace root: ${sourcePath}`);
      }
      return {
        hostPath,
        visiblePath: normalizedInput,
        groupDir: resolveGroupFolderPath(sourceGroup),
        useWorkspacePaths: true,
      };
    }
  }

  const groupDir = resolveGroupFolderPath(sourceGroup);
  const hostRoots = [
    groupDir,
    PUBLIC_KNOWLEDGE_DIR,
    SECOND_BRAIN_DIR,
    isElevated ? GROUPS_DIR : '',
    isElevated ? PROJECTS_DIR : '',
  ].filter((value): value is string => Boolean(value));

  const resolvedInput = path.resolve(sourcePath.trim());
  for (const hostRoot of hostRoots) {
    if (ensureWithinRoot(hostRoot, resolvedInput)) {
      return {
        hostPath: resolvedInput,
        visiblePath: resolvedInput,
        groupDir,
        useWorkspacePaths: false,
      };
    }
  }

  throw new Error(
    `Unsupported PDF path "${sourcePath}". Use a mounted workspace path or a visible host path inside the group workspace.`,
  );
}

function buildCachePaths(
  groupDir: string,
  hostPath: string,
  pageStart?: number,
  pageEnd?: number,
): { cacheDir: string; hostTextPath: string; containerTextPath: string } {
  const stat = fs.statSync(hostPath);
  const key = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        hostPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        pageStart: pageStart ?? null,
        pageEnd: pageEnd ?? null,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  const cacheDir = path.join(groupDir, '.nanoclaw', 'pdf-extract');
  const filename = `${key}.txt`;
  return {
    cacheDir,
    hostTextPath: path.join(cacheDir, filename),
    containerTextPath: path.posix.join(
      '/workspace/group',
      '.nanoclaw',
      'pdf-extract',
      filename,
    ),
  };
}

function readPageCount(hostPath: string): number | null {
  try {
    const output = execFileSync('pdfinfo', [hostPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = output.match(/^Pages:\s+(\d+)/m);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function extractText(
  hostPath: string,
  pageStart?: number,
  pageEnd?: number,
): string {
  const args = ['-q', '-enc', 'UTF-8', '-nopgbrk'];
  if (pageStart && pageStart > 0) {
    args.push('-f', String(pageStart));
  }
  if (pageEnd && pageEnd > 0) {
    args.push('-l', String(pageEnd));
  }
  args.push(hostPath, '-');
  return execFileSync('pdftotext', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });
}

function normalizeExcerpt(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NANOCLAW_PDF_EXTRACT_MAX_CHARS);
}

export function extractPdfText(
  request: PdfExtractionRequest,
): PdfExtractionResult {
  const { hostPath, visiblePath, groupDir, useWorkspacePaths } =
    resolveWorkspacePdfPath(
      request.sourceGroup,
      request.sourcePath,
      request.isElevated,
    );

  if (!fs.existsSync(hostPath)) {
    throw new Error(`PDF not found: ${request.sourcePath}`);
  }
  if (path.extname(hostPath).toLowerCase() !== '.pdf') {
    throw new Error(`Path is not a PDF: ${request.sourcePath}`);
  }

  const { cacheDir, hostTextPath, containerTextPath } = buildCachePaths(
    groupDir,
    hostPath,
    request.pageStart,
    request.pageEnd,
  );

  if (!fs.existsSync(hostTextPath)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const extracted = extractText(hostPath, request.pageStart, request.pageEnd);
    fs.writeFileSync(hostTextPath, extracted, 'utf8');
  }

  const text = fs.readFileSync(hostTextPath, 'utf8');
  const trimmed = text.trim();
  const characterCount = trimmed.length;
  const excerpt = normalizeExcerpt(trimmed);

  return {
    sourcePath: visiblePath,
    extractedTextPath: useWorkspacePaths ? containerTextPath : hostTextPath,
    pageCount: readPageCount(hostPath),
    characterCount,
    excerpt,
    scanCandidate: characterCount < 200,
    ocrAvailable: false,
  };
}
