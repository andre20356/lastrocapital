import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Aplica o tema antes de renderizar para evitar flash
// v2: reseta qualquer preferência antiga — padrão é sempre light (banco)
(function () {
  const stored = localStorage.getItem("lc-theme-v2");
  const theme = stored === "dark" ? "dark" : "light";
  if (!stored) localStorage.setItem("lc-theme-v2", "light");
  // limpa chave antiga se existir
  localStorage.removeItem("lc-theme");
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
})();

createRoot(document.getElementById("root")!).render(<App />);
