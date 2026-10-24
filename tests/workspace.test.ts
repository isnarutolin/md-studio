import { test } from "vitest";
import assert from "node:assert/strict";
import {
  fuzzyFiles,
  resolveDocLink,
  normalizePath,
  type FileEntry,
} from "../src/workspace";

const files = (...paths: string[]): FileEntry[] =>
  paths.map((p) => ({
    path: p,
    name: p.split("/").pop()!,
    dir: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "",
    handle: null as never,
  }));

test("normalizePath 处理 . / ..", () => {
  assert.equal(normalizePath("a/./b.md"), "a/b.md");
  assert.equal(normalizePath("a/x/../b.md"), "a/b.md");
  assert.equal(normalizePath("../b.md"), null, "越出工作区根目录应返回 null");
});

test("resolveDocLink 按当前文档目录解析", () => {
  assert.equal(resolveDocLink("notes/a.md", "b.md"), "notes/b.md");
  assert.equal(resolveDocLink("notes/a.md", "../README.md"), "README.md");
  assert.equal(resolveDocLink("README.md", "notes/a.md"), "notes/a.md");
  assert.equal(resolveDocLink("notes/a.md", "/abs/x.md"), "abs/x.md");
});

test("resolveDocLink 去掉锚点与查询串", () => {
  assert.equal(resolveDocLink("README.md", "notes/a.md#section"), "notes/a.md");
  assert.equal(resolveDocLink("README.md", "notes/a.md?x=1"), "notes/a.md");
});

test("resolveDocLink 解码百分号编码（带空格的路径）", () => {
  assert.equal(
    resolveDocLink("README.md", "notes/a%20b.md"),
    "notes/a b.md"
  );
});

test("模糊搜索：连续匹配优先于分散匹配", () => {
  const r = fuzzyFiles(files("笔记/2024/doc-045.md", "笔记/2025/doc-010.md"), "2025");
  assert.equal(r[0].path, "笔记/2025/doc-010.md", "2025 应压在 2024 之上");
});

test("模糊搜索：空格分词，多个词都要命中", () => {
  const pool = files("项目/beta/doc-032.md", "项目/alpha/doc-001.md");
  const r = fuzzyFiles(pool, "beta doc032");
  assert.equal(r.length, 1);
  assert.equal(r[0].path, "项目/beta/doc-032.md");
});

test("模糊搜索：命中文件名的排在只命中目录的前面", () => {
  const r = fuzzyFiles(files("每周报告/weekly.md", "weekly/note.md"), "weekly");
  assert.equal(r[0].path, "每周报告/weekly.md");
});

test("模糊搜索：无匹配返回空数组，空查询返回全部", () => {
  assert.equal(fuzzyFiles(files("a.md"), "zzzz").length, 0);
  assert.equal(fuzzyFiles(files("a.md", "b.md"), "   ").length, 2);
});
