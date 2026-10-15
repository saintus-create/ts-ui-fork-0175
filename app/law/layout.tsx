import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "California Law Research",
  description: "Understand California statutes, bills, court rules, cases, and Judicial Council forms with source-linked legal research.",
};

export default function LawLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
