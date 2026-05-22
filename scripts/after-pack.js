const { execSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  const productName = context.packager.appInfo.productFilename;
  const plist = path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Info.plist');
  execSync(`/usr/libexec/PlistBuddy -c "Delete :LSUIElement" "${plist}" 2>/dev/null; /usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "${plist}"`);
};
