"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

interface Props {
  initialError: string | null;
}

export function LoginForm({ initialError }: Props) {
  const router = useRouter();
  const [stage, setStage] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(initialError);
  const [pending, setPending] = useState(false);

  async function requestCode() {
    setPending(true);
    setMessage(null);
    setError(null);

    try {
      const response = await fetch("/api/internal-auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error || "Could not start sign-in.");
      setMessage(result.message || "If this email is authorized, a verification code will arrive shortly.");
      setStage("code");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start sign-in.");
    } finally {
      setPending(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await requestCode();
  }

  async function handleVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    setError(null);

    try {
      const response = await fetch("/api/internal-auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, token }),
      });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error || "Could not verify the code.");
      router.push("/prospects");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not verify the code.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="mt-7 space-y-4" onSubmit={stage === "email" ? handleSubmit : handleVerify}>
      <label className="block text-sm font-medium" htmlFor="internal-email">Email address</label>
      <input
        autoComplete="email"
        className="w-full rounded-lg border border-zinc-300 px-3 py-2.5 text-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
        id="internal-email"
        name="email"
        onChange={(event) => setEmail(event.currentTarget.value)}
        required
        type="email"
        value={email}
        readOnly={stage === "code"}
      />
      {stage === "code" && <>
        <label className="block text-sm font-medium" htmlFor="internal-token">Verification code</label>
        <input
          autoComplete="one-time-code"
          className="w-full rounded-lg border border-zinc-300 px-3 py-2.5 text-sm tracking-[0.3em] outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
          id="internal-token"
          inputMode="numeric"
          maxLength={12}
          minLength={4}
          name="token"
          onChange={(event) => setToken(event.currentTarget.value.replace(/\D/g, "").slice(0, 12))}
          pattern="[0-9]{4,12}"
          required
          value={token}
        />
      </>}
      <button
        className="w-full rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {pending ? (stage === "email" ? "Sending code…" : "Verifying…") : (stage === "email" ? "Email me a code" : "Verify code")}
      </button>
      {stage === "code" && <button
        className="w-full rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-semibold text-zinc-700 disabled:opacity-60"
        disabled={pending}
        onClick={requestCode}
        type="button"
      >
        Send a new code
      </button>}
      {message && <p aria-live="polite" className="text-sm text-emerald-800">{message}</p>}
      {error && <p aria-live="polite" className="text-sm text-red-700">{error}</p>}
    </form>
  );
}
