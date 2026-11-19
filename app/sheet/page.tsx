import type { Metadata } from "next";
import Grid from "@/components/Grid";

export const metadata: Metadata = { title: "Sales ledger · Million" };

export default function Sheet() {
  return <Grid home={{ href: "/", label: "Million" }} />;
}
