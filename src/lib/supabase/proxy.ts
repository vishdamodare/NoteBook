import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PROTECTED = ["/dashboard", "/notebooks", "/settings"];
const AUTH_PAGES = ["/login", "/signup"];

/** Refreshes the Supabase session cookie and gates protected routes. */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let response = NextResponse.next({ request });
  if (!url || !anonKey) return response; // pages will surface the configuration error

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        toSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // Do not put code between client creation and getUser(): it refreshes the session.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;
  const redirectTo = (path: string, query = "") => {
    const target = request.nextUrl.clone();
    target.pathname = path;
    target.search = query;
    const res = NextResponse.redirect(target);
    response.cookies.getAll().forEach((c) => res.cookies.set(c)); // keep refreshed session cookies
    return res;
  };

  if (!user && PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return redirectTo("/login", `?next=${encodeURIComponent(pathname + search)}`);
  }
  if (user && AUTH_PAGES.includes(pathname)) return redirectTo("/dashboard");
  return response;
}
