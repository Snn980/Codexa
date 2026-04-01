import React, { useRef, useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { CodeEditor, CodeEditorRef } from '../components/CodeEditor';
import { TabBar } from '../components/TabBar';
import { ToolBar as Toolbar } from '../components/ToolBar';
import { StatusBar } from '../components/StatusBar';
import { EmptyEditor } from '../components/EmptyEditor';
import { useEditorController } from '../hooks/useEditorController';
import { getFileName, getLanguageFromFilePath, getLineCount } from '../domain/editor.logic';

interface EditorScreenProps {
  projectId?: string;
}

export const EditorScreen: React.FC<EditorScreenProps> = ({ projectId }) => {
  const editor = useEditorController();
  const editorRef = useRef<CodeEditorRef>(null);

  useEffect(() => {
    if (!editor.activeTab) return;
    const timer = setTimeout(() => { editorRef.current?.focus(); }, 100);
    return () => clearTimeout(timer);
  }, [editor.activeTab?.id]);

  const tabItems = editor.tabs.map((tab) => ({
    id: tab.id,
    title: getFileName(tab.filePath),
    isModified: tab.isModified,
    isActive: tab.id === editor.activeTabId,
  }));

  if (editor.tabs.length === 0 || !editor.activeTab) {
    return <EmptyEditor onCreateNew={() => {}} />;
  }

  const currentTab = editor.activeTab;
  const isModified = currentTab.isModified;
  const lineCount  = getLineCount(currentTab.content);

  return (
    <View style={styles.container}>
      <Toolbar
        mode={editor.mode}
        theme={editor.theme}
        canUndo={editor.canUndo}
        canRedo={editor.canRedo}
        isModified={isModified}
        onModeChange={editor.setMode}
        onThemeChange={editor.setTheme}
        onSave={() => editor.saveTab()}
        onUndo={editor.undo}
        onRedo={editor.redo}
        onNewFile={() => {}}
      />
      <TabBar
        tabs={tabItems}
        onSelectTab={editor.selectTab}
        onCloseTab={editor.closeTab}
        onNewTab={() => {}}
      />
      <CodeEditor
        ref={editorRef}
        content={currentTab.content}
        language={getLanguageFromFilePath(currentTab.filePath)}
        theme={editor.theme}
        mode={editor.mode}
        onChange={(content) => editor.updateContent(currentTab.id, content)}
        readOnly={editor.mode === 'readonly'}
        autoFocus={true}
      />
      <StatusBar
        fileName={getFileName(currentTab.filePath)}
        lineCount={lineCount}
        isModified={isModified}
        mode={editor.mode}
        theme={editor.theme}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1e1e1e' },
});
