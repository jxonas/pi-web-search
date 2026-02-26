import { StringEnum } from "@mariozechner/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type ExtensionAPI,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const USER_AGENT = "pi-web-search/0.1.0";
const DEFAULT_MAX_RESULTS = 5;
const RECENCY_FILTERS = ["hour", "day", "week", "month", "year"] as const;
const SEARCH_MODE = "web";
const MAX_TOKENS = 10_000;
const MAX_TOKENS_PER_PAGE = 4_096;
const SEARCH_LANGUAGE_FILTER: string[] | undefined = undefined;

const WebSearchParams = Type.Object({
	query: Type.String({ description: "The web search query." }),
	max_results: Type.Optional(
		Type.Integer({
			description: "Maximum number of results to return (1-20). Defaults to 5.",
			minimum: 1,
			maximum: 20,
			default: DEFAULT_MAX_RESULTS,
		}),
	),
	allowed_domains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Restrict results to these domains, e.g. ['docs.python.org', 'nodejs.org'].",
			maxItems: 20,
		}),
	),
	blocked_domains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Exclude these domains, e.g. ['wikipedia.org'].",
			maxItems: 20,
		}),
	),
	search_recency_filter: Type.Optional(
		StringEnum(RECENCY_FILTERS, {
			description: "Restrict results by recency: hour, day, week, month, or year.",
		}),
	),
});

const WebFetchParams = Type.Object({
	url: Type.String({ description: "The URL to fetch (http or https)." }),
	max_chars: Type.Optional(
		Type.Integer({
			description: "Maximum number of characters from fetched content (default: 15000).",
			minimum: 1000,
			maximum: 100000,
			default: 15000,
		}),
	),
});

interface SearchResult {
	title?: string;
	url?: string;
	snippet?: string;
	date?: string;
	last_updated?: string;
}

function textResult(text: string, options?: { isError?: boolean; details?: unknown }) {
	return {
		content: [{ type: "text" as const, text }],
		...(options?.isError ? { isError: true } : {}),
		...(options?.details !== undefined ? { details: options.details } : {}),
	};
}

function isAbortError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "AbortError" || error.message.toLowerCase().includes("aborted"))
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/\/.*$/, "");
}

function normalizeDomains(domains?: string[]): string[] {
	if (!domains) return [];
	return domains.map(normalizeDomain).filter((d) => d.length > 0);
}

function truncateOutput(text: string): string {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) return text;

	return (
		`${truncation.content}\n\n` +
		`[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
		`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`
	);
}

function extractSearchResults(payload: unknown): SearchResult[] {
	if (!payload || typeof payload !== "object") return [];
	const record = payload as { results?: unknown };

	if (!Array.isArray(record.results)) return [];

	const first = record.results[0] as { results?: unknown } | undefined;
	if (first && typeof first === "object" && Array.isArray(first.results)) {
		return record.results
			.flatMap((entry) => {
				if (!entry || typeof entry !== "object") return [];
				const nested = (entry as { results?: unknown }).results;
				return Array.isArray(nested) ? nested : [];
			})
			.filter((entry): entry is SearchResult => !!entry && typeof entry === "object");
	}

	return record.results.filter((entry): entry is SearchResult => !!entry && typeof entry === "object");
}

function formatSearchResults(query: string, results: SearchResult[]): string {
	if (results.length === 0) {
		return `No results found for query: ${query}. Consider rephrasing or broadening your search.`;
	}

	let output = `## Search Results for: "${query}"\n\n`;

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const title = result.title?.trim() || "(Untitled)";
		const url = result.url?.trim() || "(Missing URL)";
		const date = result.date?.trim() || "Unknown";
		const snippet = result.snippet?.trim() || "(No snippet provided.)";

		output += `### ${i + 1}. ${title}\n`;
		output += `**URL**: ${url}\n`;
		output += `**Date**: ${date}\n\n`;
		output += `${snippet}\n\n---\n\n`;
	}

	return output.trim();
}

function decodeHtmlEntities(input: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
	};

	return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
		if (entity.startsWith("#x") || entity.startsWith("#X")) {
			const codePoint = Number.parseInt(entity.slice(2), 16);
			return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
		}
		if (entity.startsWith("#")) {
			const codePoint = Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
		}
		return named[entity] ?? match;
	});
}

function htmlToText(html: string): { title?: string; text: string } {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : undefined;

	let text = html;
	text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
	text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
	text = text.replace(/<(svg|canvas|template|iframe)[\s\S]*?<\/\1>/gi, " ");
	text = text.replace(/<(br|\/p|\/div|\/section|\/article|\/h[1-6]|\/li|\/pre|\/blockquote|\/tr)>/gi, "\n");
	text = text.replace(/<[^>]+>/g, " ");
	text = decodeHtmlEntities(text);
	text = text.replace(/\r/g, "");
	text = text.replace(/[ \t]+\n/g, "\n");
	text = text.replace(/\n{3,}/g, "\n\n");

	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	return {
		title,
		text: lines.join("\n"),
	};
}

function isTextContentType(contentType: string): boolean {
	const lowered = contentType.toLowerCase();
	if (lowered.startsWith("text/")) return true;
	if (lowered.includes("json")) return true;
	if (lowered.includes("xml")) return true;
	if (lowered.includes("javascript")) return true;
	if (lowered.includes("x-www-form-urlencoded")) return true;
	return false;
}

function normalizeApiErrorMessage(bodyText: string): string | undefined {
	const trimmed = bodyText.trim();
	if (!trimmed) return undefined;
	if (trimmed.length <= 400) return trimmed;
	return `${trimmed.slice(0, 400)}...`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web with Perplexity Search API and return ranked results with title, URL, date, and snippet. Use this for exploratory research or when you need up-to-date information. Prefer web_fetch when you already have a specific URL and want the page text.",
		parameters: WebSearchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			if (signal?.aborted) {
				return textResult("Search cancelled.");
			}

			const apiKey = process.env.PERPLEXITY_API_KEY;
			if (!apiKey) {
				return textResult(
					"PERPLEXITY_API_KEY is not set. Set it in your shell, e.g. `export PERPLEXITY_API_KEY=...`, then retry. You can generate a key at https://www.perplexity.ai/account/api",
					{ isError: true },
				);
			}

			const allowedDomains = normalizeDomains(params.allowed_domains);
			const blockedDomains = normalizeDomains(params.blocked_domains);
			if (allowedDomains.length > 0 && blockedDomains.length > 0) {
				return textResult("Use either allowed_domains or blocked_domains, not both in the same call.", {
					isError: true,
				});
			}

			const maxResults = clamp(params.max_results ?? DEFAULT_MAX_RESULTS, 1, 20);

			const requestBody: Record<string, unknown> = {
				query: params.query,
				max_results: maxResults,
				search_mode: SEARCH_MODE,
				max_tokens: MAX_TOKENS,
				max_tokens_per_page: MAX_TOKENS_PER_PAGE,
			};

			if (params.search_recency_filter) {
				requestBody.search_recency_filter = params.search_recency_filter;
			}
			if (SEARCH_LANGUAGE_FILTER && SEARCH_LANGUAGE_FILTER.length > 0) {
				requestBody.search_language_filter = SEARCH_LANGUAGE_FILTER;
			}
			if (allowedDomains.length > 0) {
				requestBody.search_domain_filter = allowedDomains;
			}
			if (blockedDomains.length > 0) {
				requestBody.search_domain_filter = blockedDomains.map((domain) => `-${domain}`);
			}

			onUpdate?.({ content: [{ type: "text", text: `Searching for: ${params.query}` }] });

			try {
				const response = await fetch(PERPLEXITY_SEARCH_URL, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						"User-Agent": USER_AGENT,
					},
					body: JSON.stringify(requestBody),
					signal,
				});

				if (!response.ok) {
					const responseText = await response.text().catch(() => "");
					const apiMessage = normalizeApiErrorMessage(responseText);

					if (response.status === 401) {
						return textResult(
							"Perplexity authentication failed (401). Check whether PERPLEXITY_API_KEY is valid and active.",
							{ isError: true },
						);
					}

					if (response.status === 429) {
						const retryAfter = response.headers.get("retry-after");
						const retryHint = retryAfter
							? ` Retry after approximately ${retryAfter} seconds.`
							: " Wait a moment and retry.";
						return textResult(`Perplexity rate limit reached (429).${retryHint}`, { isError: true });
					}

					if (response.status >= 500) {
						return textResult(
							`Perplexity server error (${response.status}). This is likely temporary; retry shortly.`,
							{ isError: true },
						);
					}

					return textResult(
						`Perplexity API request failed with status ${response.status}.${apiMessage ? ` Details: ${apiMessage}` : ""}`,
						{ isError: true },
					);
				}

				const payload = (await response.json()) as unknown;
				const results = extractSearchResults(payload).slice(0, maxResults);
				const output = truncateOutput(formatSearchResults(params.query, results));

				return textResult(output, {
					details: {
						query: params.query,
						resultCount: results.length,
					},
				});
			} catch (error: unknown) {
				if (signal?.aborted || isAbortError(error)) {
					return textResult("Search cancelled.");
				}

				const message = error instanceof Error ? error.message : String(error);
				return textResult(`Search request failed: ${message}`, { isError: true });
			}
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a known URL and return readable page text. Use this when you already have a specific link (for example from web_search) and need page content. Supports HTML, text, JSON, and XML responses; binary responses are rejected.",
		parameters: WebFetchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			if (signal?.aborted) {
				return textResult("Fetch cancelled.");
			}

			let targetUrl: URL;
			try {
				targetUrl = new URL(params.url);
			} catch {
				return textResult(`Invalid URL: ${params.url}`, { isError: true });
			}

			if (!["http:", "https:"].includes(targetUrl.protocol)) {
				return textResult("Only http and https URLs are supported.", { isError: true });
			}

			const maxChars = clamp(params.max_chars ?? 15000, 1000, 100000);
			onUpdate?.({ content: [{ type: "text", text: `Fetching: ${targetUrl.toString()}` }] });

			try {
				const response = await fetch(targetUrl, {
					method: "GET",
					signal,
					headers: {
						Accept: "text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.5",
						"User-Agent": USER_AGENT,
					},
				});

				if (!response.ok) {
					return textResult(`Failed to fetch ${targetUrl.toString()}: HTTP ${response.status}`, {
						isError: true,
					});
				}

				const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
				const isHtml = contentType.includes("text/html");

				if (contentType && !isHtml && !isTextContentType(contentType)) {
					return textResult(
						`Fetched content is not text-readable (content-type: ${contentType}). Use a dedicated downloader for binary files.`,
						{ isError: true },
					);
				}

				const rawText = await response.text();
				const parsed = isHtml ? htmlToText(rawText) : { title: undefined, text: rawText.trim() };

				if (!parsed.text) {
					return textResult(`Fetched ${targetUrl.toString()}, but no readable text content was extracted.`);
				}

				const charLimited = parsed.text.slice(0, maxChars);
				const wasCharTruncated = parsed.text.length > maxChars;

				let output = `## Fetched Content\n\n`;
				output += `**URL**: ${targetUrl.toString()}\n`;
				output += `**Content-Type**: ${contentType || "unknown"}\n`;
				if (parsed.title) {
					output += `**Title**: ${parsed.title}\n`;
				}
				output += "\n";
				output += charLimited;
				if (wasCharTruncated) {
					output += `\n\n[Content truncated to ${maxChars} characters.]`;
				}

				return textResult(truncateOutput(output), {
					details: {
						url: targetUrl.toString(),
						contentType: contentType || "unknown",
						wasCharTruncated,
					},
				});
			} catch (error: unknown) {
				if (signal?.aborted || isAbortError(error)) {
					return textResult("Fetch cancelled.");
				}

				const message = error instanceof Error ? error.message : String(error);
				return textResult(`Fetch failed: ${message}`, { isError: true });
			}
		},
	});
}
