/**
 * buy-vs-build (PROJECT_BRIEF.md §22) — an ADVISORY at PRD scoping. Match each
 * capability the spec implies against a registry of ~10 mature-service categories;
 * where one is covered, surface a BUY option with rationale. The deterministic part
 * is step 1 of the §22 rubric (does the registry cover it?); the cost / compliance /
 * integration judgment (steps 2-4) is the human's. Default BUILD, NEVER auto-procure
 * — this only puts the option in front of the operator so a non-technical user
 * doesn't unknowingly rebuild Stripe.
 *
 * Each advisory is framed as the first two rungs of a build-vs-complexity ladder:
 * (1) NECESSITY — do you need this capability at all? (an unrequested feature is the
 * cheapest thing to cut), then (2) if you do, prefer the proven service over rebuilding
 * the commodity. The lower rungs (platform/standard-library/existing-deps over a fresh
 * build) live in the codegen system prompt, where code is actually written — these
 * commodity categories are precisely the ones a stdlib can't stand in for.
 */
import type { Spec } from "../spec/index.ts";

export type BuyOrBuild = "buy" | "build";

export interface BuyVsBuild {
  category: string;
  recommendation: BuyOrBuild;
  service: string; // the headline suggestion (services[0]) — kept for narrative text
  services: string[]; // every accepted option for this category, e.g. ["Clerk","Auth0","Supabase Auth"] —
  // crosscheck.ts matches the architecture's declared stack against ALL of these, not just the
  // headline one, so an app that legitimately bought a different accepted option (e.g. Supabase
  // Auth instead of Clerk) isn't flagged as if it silently ignored the advisory.
  rationale: string;
}

interface Category {
  key: string;
  /** lowercase substrings that signal this capability in the spec text */
  keywords: string[];
  services: string[];
}

/** The ~10 categories where a mature service almost always beats building (§22). */
const REGISTRY: readonly Category[] = [
  { key: "payments", keywords: ["payment", "checkout", "billing", "subscription", "stripe", "charge", "credit card"], services: ["Stripe"] },
  { key: "authentication", keywords: ["auth", "login", "log in", "sign in", "sign-in", "sign up", "sign-up", "sso", "oauth"], services: ["Clerk", "Auth0", "Supabase Auth"] },
  { key: "email & notifications", keywords: ["email", "e-mail", "notification", "sms", "text message"], services: ["Resend", "SendGrid", "Twilio"] },
  { key: "search", keywords: ["full-text search", "search bar", "typeahead", "faceted search"], services: ["Algolia", "Meilisearch", "Typesense"] },
  { key: "document processing", keywords: ["ocr", "extract text", "parse pdf", "scan document", "document processing"], services: ["AWS Textract", "Google Document AI"] },
  { key: "observability", keywords: ["error tracking", "crash report", "monitoring", "observability"], services: ["Sentry", "Datadog"] },
  { key: "background jobs", keywords: ["background job", "queue", "cron", "scheduled task", "worker", "recurring job"], services: ["Inngest", "Trigger.dev"] },
  { key: "database", keywords: ["database", "postgres", "supabase", " sql "], services: ["Supabase", "Neon", "Turso"] },
  { key: "vector / RAG", keywords: ["vector", "embedding", "semantic search", "rag", "retrieval-augmented"], services: ["Pinecone", "pgvector"] },
  { key: "LLM inference", keywords: ["llm", "ai model", "chatbot", "summariz", "gpt", "claude"], services: ["Anthropic", "OpenAI"] },
];

/** Pure: scan the spec for capabilities a mature service covers → BUY advisories. */
export function buyVsBuild(spec: Spec): BuyVsBuild[] {
  const hay = ` ${spec.summary} ${spec.features.join(" ")} ${spec.auth} `.toLowerCase();
  const out: BuyVsBuild[] = [];
  for (const cat of REGISTRY) {
    if (cat.keywords.some((k) => hay.includes(k))) {
      out.push({
        category: cat.key,
        recommendation: "buy",
        service: cat.services[0]!,
        services: cat.services,
        rationale: `First ask whether you need ${cat.key} at all — an unrequested capability is the cheapest thing to cut. If you do need it, don't build it: a mature ${cat.key} service exists (${cat.services.join(" / ")}), and integrating ${cat.services[0]} is almost always safer and faster than rebuilding it — unless cost, data-residency/compliance, or integration complexity rule it out, in which case build with that rationale recorded. Default stays build; you decide.`,
      });
    }
  }
  return out;
}
