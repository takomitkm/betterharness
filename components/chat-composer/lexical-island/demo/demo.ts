// demo 入口：把 Controller 工厂挂到 window（浏览器测试经 addInitScript 注入本 bundle）。
import { createController } from "../src/create-controller.ts";

window.createController = createController;
