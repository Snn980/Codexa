import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { useAppContext } from "@/app/App";
import type { TabParamList } from "@/navigations/types";

type TabNavProp = BottomTabNavigationProp<TabParamList>;

const TabBar = () => {
  const navigation = useNavigation<TabNavProp>();
  useAppContext(); // services available if needed

  return (
    <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
      <TouchableOpacity onPress={() => navigation.navigate("ChatTab")}>
        <Text>Home</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.navigate("SettingsTab")}>
        <Text>Settings</Text>
      </TouchableOpacity>
    </View>
  );
};

export { TabBar };
export default TabBar;
