import { GetLayoutTabsOptions, LayoutTab } from "../../../layouts/shared/index.js";
import * as PageTree from "fumadocs-core/page-tree";

//#region src/components/sidebar/tabs/index.d.ts
type SidebarTab = LayoutTab;
type GetSidebarTabsOptions = GetLayoutTabsOptions;
declare function getSidebarTabs(tree: PageTree.Root, {
  transform
}?: GetSidebarTabsOptions): SidebarTab[];
//#endregion
export { GetSidebarTabsOptions, SidebarTab, getSidebarTabs };