/**
 * buy-vs-build (PROJECT_BRIEF.md §22) — an ADVISORY at PRD scoping. Match each
 * capability the spec implies against a registry of ~10 mature-service categories;
 * where one is covered, surface a BUY option with rationale. The deterministic part
 * is step 1 of the §22 rubric (does the registry cover it?); the cost / compliance /
 * integration judgment (steps 2-4) is the human's. Default BUILD, NEVER auto-procure
 * — this only puts the option in front of the operator so a non-technical user
 * doesn't unknowingly rebuild Stripe.
 */
import type { Spec } from "../spec/index.ts";

export type BuyOrBuild = "buy" | "build";

export interface BuyVsBuild {
  category: string;
  recommendation: BuyOrBuild;
  service: string; // the suggested service when recommending buy
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
        rationale: `A mature ${cat.key} service exists (${cat.services.join(" / ")}). Integrating ${cat.services[0]} is almost always safer and faster than building it — unless cost, data-residency/compliance, or integration complexity rule it out, in which case build with that rationale recorded. Default stays build; you decide.`,
      });
    }
  }
  return out;
}
