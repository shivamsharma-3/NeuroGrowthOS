import { LoginForm } from "@/components/auth/login-form";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const error = params.error === "not_authorized"
    ? "This account is not authorized for internal access."
    : params.error === "sign_in"
      ? "The verification code could not be verified. Request a new code and try again."
      : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 py-12 text-zinc-900">
      <section className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">GrowthOS AI · Internal</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">Enter your authorized email to receive a one-time verification code.</p>
        <LoginForm initialError={error} />
      </section>
    </main>
  );
}
