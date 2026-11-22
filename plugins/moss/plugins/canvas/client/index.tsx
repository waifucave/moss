// The canvas's client entry: MOSS Code's start page (`main` keyed `start`), its line and + on the window's bar
// (`page.bar` keyed `start`) and the session tab's corner switch (`session.corner`). It imports no CSS: `client.css` lists the stylesheet.
export { Canvas } from "./Canvas";
export type { CanvasProps, View } from "./Canvas";
export { CanvasBar, CanvasCorner, CanvasStart } from "./entry";
export type { CanvasBarProps, CanvasCornerProps, CanvasStartProps } from "./entry";
export { TOKENS } from "./tokens";
