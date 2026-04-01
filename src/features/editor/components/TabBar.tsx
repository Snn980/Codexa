// components/TabBar.tsx
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';

export interface Tab {
  id: string;
  title: string;
  isModified: boolean;
  isActive: boolean;
}

interface TabBarProps {
  tabs: Tab[];
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
}

export const TabBar: React.FC<TabBarProps> = ({ tabs, onSelectTab, onCloseTab, onNewTab }) => {
  const handleClose = (e: any, tabId: string) => {
    e.stopPropagation(); // ✅ Prevent tab selection when closing
    onCloseTab(tabId);
  };

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        {tabs.map((tab) => (
          <TouchableOpacity
            key={tab.id}
            style={[styles.tab, tab.isActive && styles.activeTab]}
            onPress={() => onSelectTab(tab.id)}
            activeOpacity={0.7}
          >
            <Text
              style={[styles.tabText, tab.isActive && styles.activeTabText]}
              numberOfLines={1}
            >
              {tab.title}
              {tab.isModified && ' ●'}
            </Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={(e) => handleClose(e, tab.id)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              activeOpacity={0.6}
            >
              <Text style={styles.closeText}>✕</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <TouchableOpacity
        style={styles.newButton}
        onPress={onNewTab}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        activeOpacity={0.7}
      >
        <Text style={styles.newText}>+</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: '#252526',
    borderBottomWidth: 1,
    borderBottomColor: '#3e3e42',
    height: 36,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexDirection: 'row',
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    backgroundColor: '#2d2d30',
    borderRightWidth: 1,
    borderRightColor: '#3e3e42',
    height: 35,
    gap: 8,
  },
  activeTab: {
    backgroundColor: '#1e1e1e',
  },
  tabText: {
    color: '#cccccc',
    fontSize: 12,
    maxWidth: 150,
  },
  activeTabText: {
    color: '#ffffff',
  },
  closeButton: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 2,
  },
  closeText: {
    color: '#cccccc',
    fontSize: 10,
    fontWeight: 'bold',
  },
  newButton: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2d2d30',
    borderLeftWidth: 1,
    borderLeftColor: '#3e3e42',
  },
  newText: {
    color: '#cccccc',
    fontSize: 18,
    fontWeight: 'bold',
  },
});