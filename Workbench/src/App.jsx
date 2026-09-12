import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { DocumentDrawer } from "./components/DocumentDrawer";
import { SearchPalette } from "./components/SearchPalette";
import { CollectionPage } from "./pages/CollectionPage";
import { DouyinPage } from "./pages/DouyinPage";
import { DailyHotPage } from "./pages/DailyHotPage";
import { GraphPage } from "./pages/GraphPage";
import { MaterialsPage } from "./pages/MaterialsPage";
import { BooksPage } from "./pages/BooksPage";
import { LearningPage } from "./pages/LearningPage";
import { LearningProjectPage } from "./pages/LearningProjectPage";
import { JobTrackerPage } from "./pages/JobTrackerPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SystemPage } from "./pages/SystemPage";
import { TopicsPage } from "./pages/TopicsPage";
import { SocialInsightsPage, SocialTrendDetailPage } from "./pages/SocialInsightsPage";
import { useVaultSync } from "./hooks/useVaultSync";

const localWorkbench = import.meta.env.VITE_WORKBENCH_HOSTED !== "true";

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedDocumentId, setSelectedDocumentId] = useState(null);
  const [readerContext, setReaderContext] = useState(null);
  const vaultSync = useVaultSync(location.pathname);
  const routeRevision =
    location.pathname.startsWith("/social-insights")
    ? location.pathname
    : `${location.pathname}:${vaultSync.revision}`;

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    setSearchOpen(false);
    setSelectedDocumentId(null);
    setReaderContext(null);
  }, [location.pathname]);

  const openDocument = useCallback((documentOrId) => {
    const id =
      typeof documentOrId === "string"
        ? documentOrId
        : documentOrId?.id ?? documentOrId?.relativePath;
    if (id) {
      setSelectedDocumentId(id);
      setReaderContext(
        typeof documentOrId === "object" ? documentOrId.readerContext || null : null,
      );
    }
  }, []);

  const appContext = useMemo(
    () => ({
      navigate,
      openDocument,
      openSearch: () => setSearchOpen(true),
    }),
    [navigate, openDocument],
  );

  return (
    <>
      <AppShell onOpenSearch={appContext.openSearch} sync={vaultSync}>
        <Routes key={routeRevision}>
          <Route path="/" element={<OverviewPage onOpenDocument={openDocument} />} />
          <Route path="/graph" element={<GraphPage onOpenDocument={openDocument} />} />
          <Route
            path="/wiki"
            element={
              <CollectionPage
                kind="wiki"
                eyebrow="KNOWLEDGE LAYER"
                title="Wiki 层"
                description="结构化知识：来源拆解、概念、框架、诊断与待验证问题。星图的线性视图。"
                onOpenDocument={openDocument}
              />
            }
          />
          <Route
            path="/materials"
            element={<MaterialsPage onOpenDocument={openDocument} />}
          />
          <Route path="/learning" element={<LearningPage />} />
          <Route path="/learning/:projectSlug" element={<LearningProjectPage onOpenDocument={openDocument} />} />
          {localWorkbench ? (
            <Route path="/jobs" element={<JobTrackerPage />} />
          ) : null}
          <Route path="/books" element={<BooksPage onOpenDocument={openDocument} />} />
          <Route path="/books/:bookId" element={<BooksPage onOpenDocument={openDocument} />} />
          <Route path="/daily-hot" element={<DailyHotPage />} />
          {localWorkbench ? (
            <Route
              path="/social-insights"
              element={
                <SocialInsightsPage
                  onOpenDocument={openDocument}
                  syncRevision={vaultSync.revision}
                />
              }
            />
          ) : null}
          {localWorkbench ? (
            <Route
              path="/social-insights/trends/:trendId"
              element={
                <SocialTrendDetailPage
                  onOpenDocument={openDocument}
                  syncRevision={vaultSync.revision}
                />
              }
            />
          ) : null}
          {localWorkbench ? (
            <Route
              path="/social-insights/:reportId"
              element={
                <SocialInsightsPage
                  onOpenDocument={openDocument}
                  syncRevision={vaultSync.revision}
                />
              }
            />
          ) : null}
          <Route
            path="/topics"
            element={<TopicsPage onOpenDocument={openDocument} />}
          />
          <Route
            path="/content"
            element={
              <CollectionPage
                kind="content"
                eyebrow="CONTENT PIPELINE"
                title="内容中心"
                onOpenDocument={openDocument}
              />
            }
          />
          <Route path="/douyin" element={<DouyinPage />} />
          <Route path="/system" element={<SystemPage />} />
          <Route path="*" element={<Navigate replace to="/" />} />
        </Routes>
      </AppShell>

      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenDocument={(document) => {
          openDocument(document);
          setSearchOpen(false);
        }}
      />

      <DocumentDrawer
        documentId={selectedDocumentId}
        onNavigateDocument={openDocument}
        onClose={() => {
          setSelectedDocumentId(null);
          setReaderContext(null);
        }}
        readingContext={readerContext}
      />
    </>
  );
}
