import Link from "next/link";
import { Activity, GitBranch, Search, ShieldCheck, Terminal } from "lucide-react";
import { Badge, Button, Card, CardContent } from "@/components/ui";

const STEPS = [
  {
    icon: Activity,
    title: "Detect",
    body: "Exceptions and server errors, plus the silent failures nothing else catches. A button that stops firing throws nothing, so no tool reports it.",
  },
  {
    icon: GitBranch,
    title: "Attribute",
    body: "Reads your git history to find the change that caused it. No integration to set up, the repository already knows.",
  },
  {
    icon: Search,
    title: "Locate",
    body: "Five retrieval signals, stack frames, changed files, symbols, keywords, imports, fused into one ranked list of the code that matters.",
  },
  {
    icon: ShieldCheck,
    title: "Repair",
    body: "Writes the fix, measures it against a deterministic score, keeps it only if it improved. Lands on a per-area branch as a reviewable PR.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="container flex h-16 items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <span className="text-sm font-bold">R</span>
            </div>
            Recursive
          </div>
          <nav className="flex items-center gap-2">
            <Button variant="ghost" asChild>
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild>
              <Link href="/signup">Get started</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main>
        <section className="container py-24 text-center">
          <Badge variant="secondary" className="mb-6">
            Installs into your codebase
          </Badge>
          <h1 className="mx-auto max-w-3xl text-5xl font-semibold tracking-tight sm:text-6xl">
            Software that fixes itself
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            Error tracking tells you what crashed. It never tells you about the button that quietly
            stopped working, no crash, no ticket, just revenue drifting down for weeks. Recursive
            finds those, works out which change caused them, and opens the fix.
          </p>

          <div className="mt-10 flex items-center justify-center gap-3">
            <Button size="lg" asChild>
              <Link href="/signup">Create an account</Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/login">Sign in</Link>
            </Button>
          </div>

          <Card className="mx-auto mt-14 max-w-xl text-left">
            <CardContent className="p-0">
              <div className="flex items-center gap-2 border-b px-4 py-2.5 text-xs text-muted-foreground">
                <Terminal className="h-3.5 w-3.5" />
                your terminal
              </div>
              <pre className="overflow-x-auto p-4 font-mono text-sm leading-relaxed">
                <code>
                  <span className="text-muted-foreground">$ </span>npm install -g @recursive/cli
                  {"\n"}
                  <span className="text-muted-foreground">$ </span>recursive login{"\n"}
                  <span className="text-muted-foreground"> Your code: </span>
                  <span className="text-success">KTPD-9M4X</span>
                  {"\n"}
                  <span className="text-muted-foreground"> ✓ Signed in as you@company.com</span>
                  {"\n\n"}
                  <span className="text-muted-foreground">$ </span>recursive watch{"\n"}
                  <span className="text-muted-foreground">
                    {" "}
                    watching 1,284 files · reporting to dashboard
                  </span>
                </code>
              </pre>
            </CardContent>
          </Card>
        </section>

        <section className="border-t bg-muted/30 py-20">
          <div className="container">
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step) => (
                <Card key={step.title}>
                  <CardContent className="p-6">
                    <step.icon className="h-5 w-5 text-muted-foreground" />
                    <h3 className="mt-4 font-semibold">{step.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      {step.body}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section className="container py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight">Every run is recorded</h2>
            <p className="mt-4 text-muted-foreground">
              Each session shows what Recursive looked at, what it decided, and whether it was
              right. Including when a fix was rejected, the rejections are how the system earns
              trust, and how it gets better.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t py-8">
        <div className="container text-center text-sm text-muted-foreground">
          Recursive, detect, contain, repair, verify.
        </div>
      </footer>
    </div>
  );
}
