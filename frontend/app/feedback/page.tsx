"use client";

import { PageHeader } from "../components/layout/PageHeader";
import { Star } from "lucide-react";
import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

const categories = [
  { key: "general", label: "General Feedback" },
  { key: "feature_request", label: "Feature Request" },
  { key: "improvement", label: "Improvement" },
  { key: "missing_tool", label: "Missing Tool" },
  { key: "bug", label: "Bug Report" },
];

export default function FeedbackPage() {
  const { session } = useAuth();
  const [category, setCategory] = useState("general");
  const [message, setMessage] = useState("");
  const [rating, setRating] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const handleSubmit = async () => {
    if (!message.trim() || message.trim().length < 5) {
      setResult({ type: "error", text: "Please write at least a few words" });
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (session?.access_token) {
        headers.Authorization = `Bearer ${session.access_token}`;
      }

      const res = await fetch(`${API_URL}/api/feedback`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          category,
          message: message.trim(),
          rating: rating || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail || "Failed to submit");
      setResult({ type: "success", text: "Thank you! Your feedback has been submitted." });
      setMessage("");
      setRating(0);
    } catch (err: any) {
      setResult({ type: "error", text: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader eyebrow="Support" title="Help us improve your workspace" description="Report an issue, suggest a tool, or share what works for your trading routine." />
      <div className="bg-card border border-card-border rounded-xl p-5 sm:p-7">
        <h2 className="mb-3 text-sm font-semibold text-text-heading">What is your feedback about?</h2>
        {/* Category pills */}
        <div className="flex gap-1.5 mb-3.5 flex-wrap">
          {categories.map((c) => (
            <button
              key={c.key}
              aria-pressed={category === c.key}
              onClick={() => setCategory(c.key)}
              className={`px-3 py-[5px] rounded-lg text-[11px] font-semibold cursor-pointer border transition-colors ${
                category === c.key
                  ? "bg-accent/[0.13] border-accent/[0.25] text-accent"
                  : "bg-surface-subtle border-card-border text-text-secondary hover:text-muted"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Message */}
        <label htmlFor="feedback-message" className="mb-2 mt-6 block text-sm font-semibold">Your feedback</label>
        <textarea id="feedback-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What's on your mind? What features would you like to see? Any issues you've encountered?"
          className="w-full min-h-[180px] px-3.5 py-3 bg-input-bg border border-input-border rounded-[10px] text-[13px] text-text-heading resize-y outline-none leading-relaxed focus:border-accent/50 transition-colors"
        />

        {/* Rating + Submit */}
        <div className="flex flex-wrap justify-between items-center gap-5 mt-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-text-secondary font-medium">Rate your experience:</span>
            <div className="flex gap-0.5">
              {[1, 2, 3, 4, 5].map((star) => (
                <button type="button" aria-label={`Rate ${star} ${star === 1 ? "star" : "stars"}`} aria-pressed={rating === star}
                  key={star}
                  onClick={() => setRating(star === rating ? 0 : star)}
                  className={`p-2 rounded-lg transition-colors ${
                    star <= rating ? "text-amber-500" : "text-card-border"
                  }`}
                >
                  <Star size={20} fill={star <= rating ? "currentColor" : "none"} />
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {result && (
              <span role="status"
                className={`text-[11px] font-semibold ${
                  result.type === "success" ? "text-accent" : "text-loss"
                }`}
              >
                {result.text}
              </span>
            )}
            <button
              onClick={handleSubmit}
              disabled={submitting || message.trim().length < 5}
              className="bg-accent text-white border-none rounded-lg px-[22px] py-[9px] text-xs font-bold cursor-pointer disabled:opacity-50 hover:bg-accent/80 transition-colors"
            >
              {submitting ? "Sending..." : "Submit Feedback"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
