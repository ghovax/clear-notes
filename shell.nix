{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = [
    pkgs.nodejs_20
    pkgs.nodePackages.npm
  ];
  
  shellHook = ''
    echo "Node.js development environment"
    echo "Node.js version: $(node -v)"
    echo "npm version: $(npm -v)"
  '';
} 