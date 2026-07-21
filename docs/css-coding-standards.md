# CSS 编写规范

> 基于 CatStudy 项目实际踩坑总结。每条规范背后都有具体的问题案例。

---

## 一、动画与过渡

### 1.1 禁止 transition `grid-template-columns` / `grid-template-rows`

**原因**：浏览器以整数值步进动画 grid track，中间帧没有亚像素平滑。每帧触发完整的 layout 重算（不是 composite），导致内部内容（尤其是文本）在每帧重新排布，产生可见的上下抖动。

**案例**：`App.vue` 面板展开/折叠时，session 标题和聊天气泡向上跳 1-2px。根因是 `transition: grid-template-columns 0.2s ease` 导致中间列每帧重算 `1fr`。

**正确做法**：

- 面板切换用**即时切换**（无 transition），不产生中间帧
- 如果未来需要平滑动画，用 **View Transitions API**（`document.startViewTransition()`），在合成器线程对快照做 crossfade，零 layout 重算

```css
/* ❌ 错误 */
.app-layout {
  transition: grid-template-columns 0.2s ease;
}

/* ✅ 正确：无 transition，即时切换 */
.app-layout {
  /* 不写 transition */
}
```

```typescript
// ✅ 未来可选：View Transitions API（平滑动画，无 jitter）
function toggleSidebar() {
  if ('startViewTransition' in document) {
    document.startViewTransition(() => {
      isOpen.value = !isOpen.value
    })
  } else {
    isOpen.value = !isOpen.value
  }
}
```

### 1.2 优先用 `transform` + `opacity` 做动画

**原因**：这两个属性只触发 composite，不触发 layout/paint。GPU 直接处理，60fps 稳。

| 属性                                   | 触发阶段                   | 性能      |
| -------------------------------------- | -------------------------- | --------- |
| `transform`, `opacity`                 | Composite only             | ✅ 最优   |
| `color`, `background-color`            | Paint + Composite          | ⚠️ 可接受 |
| `width`, `height`, `padding`, `margin` | Layout → Paint → Composite | ❌ 避免   |
| `grid-template-*`, `flex-basis`        | Layout → Paint → Composite | ❌ 禁止   |

### 1.3 `fr` 单位在动画中的陷阱

**原因**：`fr` 是运行时计算值——`1fr = (容器宽 - 固定轨道 - gap) / fr 总和`。在动画的每一帧中，固定轨道的插值变化导致 `1fr` 每帧重算，产生亚像素取整差异。

**正确做法**：需要动画的轨道用固定值（px / %），不用 `fr`。

---

## 二、字号与排版

### 2.1 基础字号不低于 16px

**原因**：浏览器默认字号是 16px。WCAG 2.1 以此为最低基准。暗色模式下 CJK 文字在 14px 时笔画粘连严重。

**案例**：猫咖 body 原本 `font-size: 14px`，改为 16px 后阅读舒适度明显提升。

### 2.2 新代码的 `font-size` 一律用 `rem`

**原因**：`px` 写死的字号不响应根字号变化。body 从 14px 改到 16px 时，所有 `px` 写死的辅助文字（9/10/11px）原地踏步，层级差反而拉大。

```css
/* ❌ 错误 */
.label {
  font-size: 12px;
}

/* ✅ 正确 */
.label {
  font-size: 0.75rem;
} /* 12/16 = 0.75 */
```

### 2.3 阅读宽度用 `ch` 单位

**原因**：`ch` 是字体自限性单位——等于当前字体的 "0" 字符宽度。`max-width: 65ch` 在任何屏幕、任何字号下都保证 65 字符/行，不需要手动为不同断点计算 px 值。

**案例**：猫咖消息气泡从 `max-width: 72%` 改为 `max-width: 65ch`，宽屏上不再超过 75 字符阅读舒适上限。

---

## 三、滚动条

### 3.1 `scrollbar-width` 不继承

**原因**：CSS 规范明确 `scrollbar-width` 是 non-inherited 属性。放在 `html` 或 `body` 上不会自动作用于子元素滚动区域。

**案例**：猫咖 `html { scrollbar-width: thin }` 对 `.chat-messages`、`.session-items` 等子元素无效。Firefox 用户看到的是 17px 默认粗滚动条。修复方式：列出所有实际滚动的容器选择器。

```css
/* ❌ 错误：不继承，对子元素无效 */
html {
  scrollbar-width: thin;
}

/* ✅ 正确：精确作用到每个滚动容器 */
.chat-messages,
.session-items,
.agent-cards,
.collapsed-sessions,
.collapsed-agents,
.modal,
.panel-inner,
.mention-dropdown {
  scrollbar-width: thin;
  scrollbar-color: var(--border-table) transparent;
}
```

### 3.2 `scrollbar-color` 是继承属性

**原因**：与 `scrollbar-width` 不同，`scrollbar-color` 是 inherited 属性。放 `html` 上可以有效透传。但配合 `scrollbar-width` 使用时，建议两个属性一起写在滚动容器上，保持一致性。

### 3.3 自定义滚动条宽度底线 10px

**原因**：WCAG 2.2 SC 2.5.8 要求交互目标最小 24×24 CSS 像素。自定义滚动条（`::-webkit-scrollbar`）会使浏览器默认的 "User Agent Control" 豁免失效。低于 8px 的滚动条对部分键盘鼠标模拟器（鼠标坐标以 8px 量子移动）完全无法点击。

**猫咖采用的方案（border 技法）**：

- 轨道宽 10px，thumb 用 `border-left/right: 3px transparent` → 视觉 ~4px 精致
- hover 时 `border: 0` → 点击目标扩到 10px
- 加 `transition: border 0.15s ease` 使过渡平滑

---

## 四、布局

### 4.1 Flex/Grid 容器默认 `align-items: stretch` 的副作用

**原因**：默认值 `stretch` 会让子元素在交叉轴方向拉伸。当容器宽度在动画中变化时，子元素的高度可能随宽度联动（例如文本换行变化导致高度变化）。

**正确做法**：对不需要拉伸的子元素显式设置 `align-items: flex-start` 或 `align-self: flex-start`。

### 4.2 `flex-wrap: wrap` 在宽度变化的容器中不稳定

**原因**：当容器宽度在动画中变化时，`flex-wrap` 的 wrap/unwrap 边界条件触发的瞬间，子元素从同一行跳到下一行，产生视觉跳动。

**案例**：猫咖 `.message` 用 `flex-wrap: wrap`，在 grid 列宽 transition 期间可能触发 wrap/unwrap 交替。

### 4.3 `overflow: hidden` 不是 `overflow-y: auto` 的替代

**原因**：`overflow: hidden` 会完全裁剪溢出内容，用户无法滚动。对被裁剪的内容没有视觉提示。只应在确定不需要滚动的容器上使用。

---

## 五、CSS 自定义属性（Design Tokens）

### 5.1 颜色一律用 CSS 变量

**原因**：暗色主题项目，颜色值分散在各处极难维护。统一通过 `index.html` 的 `:root` 定义 Design Tokens。

**猫咖当前 Token 体系**：

- `--bg-*`：背景色（base / deep / surface / hover）
- `--text-*`：文字色（primary / secondary / muted）
- `--border-*`：边框色（subtle / default / table）
- `--accent`：主题色
- `--accent-red`：危险色
- `--radius-*`：圆角（sm / md / lg）
- `--shadow-*`：阴影（sm）
- `--ease-out`：过渡缓动

### 5.2 新颜色必须先定义为 Token

**原因**：避免魔法色值分散在组件中。即使只用一次，也定义 Token——未来换主题时一键改。

---

## 六、选择器

### 6.1 写选择器前先确认 DOM 中的实际 class 名

**原因**：凭记忆写的 class 名大概率跟实际 DOM 对不上。

**案例**：猫咖 Firefox 滚动条修复经历两轮返工——第一轮写了 5 个错误的 class 名（`.agent-items` → 实际是 `.agent-cards`，`.panel-column` → 实际是 `.panel-inner`，等等）。工具辅助：`grep -r "class=" packages/web/src/` 确认。

### 6.2 避免后代选择器控制变体样式

**原因**：`.parent .child` 把样式绑定到 DOM 结构上。重构 DOM（如日期分隔从 `.message` 内部移到外部）时，后代选择器静默失效。

**正确做法**：用独立的 class 名表达变体。

```css
/* ❌ 错误：绑定到 DOM 结构 */
.message.system .date-separator span { ... }

/* ✅ 正确：独立 class */
.date-sep-system span { ... }
```

---

## 七、TypeScript / Vue 集成

### 7.1 Socket 事件类型标注必须与服务端一致

**原因**：客户端缩减类型标注会丢弃字段，导致运行时 guard 漏检。

**案例**：猫咖 `AGENT_TYPING` handler 的类型标注丢弃了 `sessionId`，导致跨会话流式气泡泄漏 bug。修复时补全了类型 + 加了 sessionId 守卫。

```typescript
// ❌ 错误：丢弃了服务端发送的 sessionId
socket.on(Events.AGENT_TYPING, (data: { agentId: string; messageId: string; content: string }) => {
  typingStates.value.set(data.agentId, data)
})

// ✅ 正确：完整标注
socket.on(
  Events.AGENT_TYPING,
  (data: { agentId: string; messageId: string; content: string; sessionId: string }) => {
    if (data.sessionId !== activeSessionId.value) return
    typingStates.value.set(data.agentId, data)
  }
)
```

### 7.2 Vue computed 在 script 中访问必须加 `.value`

**原因**：Vue 3 `computed()` 返回 `ComputedRef<T>`，script 中访问需要 `.value`，模板中自动解包。

```typescript
// ❌ 错误：computed 内部忘了 .value
const activeTypingStates = computed(() => {
  const filtered = new Map()
  store.typingStates.forEach((v, agentId) => {
    // ComputedRef，没有 .forEach → 运行时错误
    // ...
  })
  return filtered
})

// ✅ 正确：加 .value 访问底层 Map
const activeTypingStates = computed(() => {
  const filtered = new Map()
  store.typingStates.value.forEach((v, agentId) => {
    // 实际 Map，有 .forEach ✅
    // ...
  })
  return filtered
})
```

---

## 八、检查清单

写 CSS 之前：

- [ ] 这个属性能 transition 吗？（查 [CSS Animatable Properties](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_animated_properties)）
- [ ] 这个属性会触发 layout 吗？（查 [CSS Triggers](https://csstriggers.com/)）
- [ ] `scrollbar-width` 写到实际滚动的元素上了吗？（不继承）
- [ ] 选择器的 class 名跟 DOM 一致吗？（grep 确认）
- [ ] 字号用了 `rem` 吗？（不是 `px`）
- [ ] 颜色用了 CSS 变量吗？（不是魔法值）
- [ ] 变体样式用了独立 class 吗？（不是后代选择器）
