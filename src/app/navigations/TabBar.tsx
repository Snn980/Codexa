import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useAppContext } from "@/app/AppContainer";

const TabBar = () => {
  const navigation = useNavigation();
  const { state } = useAppContext();

  return (
    <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
      <TouchableOpacity onPress={() => navigation.navigate("Home" as never)}>
        <Text>Home</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.navigate("Settings" as never)}>
        <Text>Settings</Text>
      </TouchableOpacity>
    </View>
  );
};

export default TabBar;
