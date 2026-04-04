import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

interface EmptyEditorProps {
  onCreateNew: () => void;
  paddingTop?: number;
}

export const EmptyEditor: React.FC<EmptyEditorProps> = ({ onCreateNew, paddingTop = 0 }) => (
  <View style={[styles.container, { paddingTop }]}>
    <View style={styles.inner}>
      <Text style={styles.icon}>{ }</Text>
      <Text style={styles.title}>Editör</Text>
      <Text style={styles.desc}>
        Projeler sekmesinden bir proje açın{'\n'}veya yeni dosya oluşturun.
      </Text>
      <TouchableOpacity style={styles.btn} onPress={onCreateNew}>
        <Text style={styles.btnText}>+ Yeni Dosya</Text>
      </TouchableOpacity>
      <View style={styles.hints}>
        <Text style={styles.hint}>↑ Projeler → proje seç → dosyalar otomatik açılır</Text>
      </View>
    </View>
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1e1e1e' },
  inner:     { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  icon:      { fontSize: 40 },
  title:     { fontSize: 16, fontWeight: '700', color: '#d4d4d4', fontFamily: MONO },
  desc:      { fontSize: 12, color: '#6e6e6e', fontFamily: MONO,
               textAlign: 'center', lineHeight: 20 },
  btn:       { marginTop: 8, paddingHorizontal: 20, paddingVertical: 10,
               backgroundColor: '#0e639c', borderRadius: 6 },
  btnText:   { color: '#fff', fontSize: 13, fontWeight: '600', fontFamily: MONO },
  hints:     { marginTop: 24, padding: 12, borderRadius: 6,
               backgroundColor: 'rgba(255,255,255,0.04)',
               borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  hint:      { fontSize: 11, color: '#4e4e4e', fontFamily: MONO, textAlign: 'center' },
});
