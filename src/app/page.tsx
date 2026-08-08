import { AppShell } from "@/components/app-shell";
import { ThemeProvider } from "@/components/theme-provider";

export default function Home() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}
