import { useState } from "react";
import { useRouter } from "next/router";
import Head from "next/head";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        router.push("/");
      } else {
        setError("Invalid password");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Head>
        <title>Southern Marinas Dashboard - Login</title>
        <link
          href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </Head>
      <div className="min-h-screen bg-navy flex items-center justify-center font-montserrat">
        <div className="bg-white rounded-xl shadow-2xl p-8 w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="text-4xl mb-3">⚓</div>
            <h1 className="text-2xl font-bold text-navy">Southern Marinas</h1>
            <p className="text-gray-500 text-sm mt-1">Lead Response Dashboard</p>
          </div>
          <form onSubmit={handleSubmit}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gold focus:border-transparent text-center"
              autoFocus
            />
            {error && (
              <p className="text-red-500 text-sm mt-2 text-center">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full mt-4 bg-gold hover:bg-yellow-600 text-white font-semibold py-3 rounded-lg transition-colors disabled:opacity-50"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
