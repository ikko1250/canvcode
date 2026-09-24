/** @jsxImportSource preact */
import '@fontsource/m-plus-1p/400.css';
import '@fontsource/m-plus-1p/700.css';
import './editor.css';
import { render } from "preact";
import { App } from "./components/App.tsx";

const root = document.getElementById("app");
if (!root) {
  throw new Error("#app 要素が見つかりません。");
}
render(<App />, root);
