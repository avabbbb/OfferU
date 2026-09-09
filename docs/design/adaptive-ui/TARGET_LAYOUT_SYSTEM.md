# Target Layout System

## Layering

```text
dynamic viewport root
  -> Adaptive Workbench Shell
    -> page composition (media query)
      -> container-aware cards/forms/panels (container query)
        -> bounded overflow region
```

## Tokens and primitives

页面组合使用 Tailwind 断点；可复用组件按容器空间变化。新增布局优先使用：

- `min-width: 0` / `min-height: 0`
- `minmax(0, 1fr)`、`auto-fit`、`clamp()`
- `.offeru-viewport-shell` 和 `.offeru-viewport-min-height`
- `ResponsiveStack`、`ResponsiveGrid`、`AdaptiveMasterDetail`、`AdaptiveModal`（只有有 2–3 个 caller 时才抽取）

组件的 card、provider、route row、agent connection panel 应设置 `container-type: inline-size`，根据可用容器重排 header、metadata 和 actions。Media query 只负责全局导航、页面级组合、pointer/hover 和 reduced motion。

## Composition rules

- Wide：保留多栏工作区和 inline actions。
- Medium：侧栏可折叠，Inspector/Context 转 drawer 或可切换区域。
- Compact：master-detail、sheet 或单列流；能力通过“更多”收纳，不能因为宽度删除。
- Short height：panel/modal 自己滚动，主要 CTA 保持可达。
- Data-heavy table：只允许表格容器横向滚动，禁止整 App 横向滚动。
- Canvas exception：二维画布可内部 pan/zoom；外围 toolbar、dialog、inspector 仍要 reflow。OfferU 当前无 Infinite Canvas，实现应在 Flovart 仓库验收。

## Viewport contract

```css
html, body, #root { min-height: 100%; }
.offeru-viewport-shell { height: 100vh; height: 100dvh; }
.offeru-viewport-min-height { min-height: 100vh; min-height: 100dvh; }
```

布局 resize 不得触发 Provider discovery、model fetch、workflow save 或其它业务请求。需要拖拽边界的交互逻辑可以监听 resize，但必须局部更新并有明确的 caller 注释。
